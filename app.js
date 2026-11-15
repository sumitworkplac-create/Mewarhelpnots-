const sb = window.supabase.createClient(window.MEWAR_CONFIG.SUPABASE_URL, window.MEWAR_CONFIG.SUPABASE_ANON_KEY);

let currentUser = null;
let profile = null;
let page = "home";
let previewRole = "admin";
let searchQuery = "";
let state = { questions: [], answers: [], materials: [], outbox: [] };
let pendingImageFile = null;
let pendingAudioBlob = null;
let mediaRecorder = null;
let audioChunks = [];
let isTyping = false;
let needsRender = false;

const el = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
const effectiveRole = () => (profile?.role === "admin" ? previewRole : profile?.role || "student");
const fmtDate = (d) => new Date(d).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

function toast(msg, type = "success") {
  const t = document.createElement("div");
  t.className = `toast ${type}`;
  t.textContent = msg;
  el("toast-box").appendChild(t);
  setTimeout(() => t.remove(), 4000);
}

// Typing-safe render so typing a reply never gets wiped by realtime updates
el("main-content").addEventListener("focusin", (e) => {
  if (["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName)) isTyping = true;
});
el("main-content").addEventListener("focusout", () => {
  setTimeout(() => { isTyping = false; if (needsRender) { needsRender = false; render(); } }, 250);
});
function safeRender() {
  if (isTyping) needsRender = true;
  else render();
}

// Web Push Registration
async function enablePush() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !window.MEWAR_CONFIG.VAPID_PUBLIC_KEY) return;
  try {
    const reg = await navigator.serviceWorker.register("./sw.js");
    const perm = await Notification.requestPermission();
    if (perm !== "granted") return;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      const padding = "=".repeat((4 - (window.MEWAR_CONFIG.VAPID_PUBLIC_KEY.length % 4)) % 4);
      const b64 = (window.MEWAR_CONFIG.VAPID_PUBLIC_KEY + padding).replace(/-/g, "+").replace(/_/g, "/");
      const raw = atob(b64);
      const key = Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    }
    await sb.from("push_subscriptions").upsert({
      user_id: currentUser.id,
      endpoint: sub.endpoint,
      subscription_json: sub.toJSON()
    }, { onConflict: "endpoint" });
  } catch (_) {}
}

// Auth
el("google-login-btn").onclick = async () => {
  const { error } = await sb.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: window.location.origin + window.location.pathname }
  });
  if (error) {
    el("auth-error").textContent = error.message;
    el("auth-error").classList.remove("hidden");
  }
};

el("logout-btn").onclick = async () => {
  await sb.auth.signOut();
  window.location.reload();
};

// Profile Modal
el("p-role").onchange = () => {
  const show = el("p-role").value !== "student";
  el("p-passcode").classList.toggle("hidden", !show);
  el("p-passcode").required = show;
};
el("p-cancel").onclick = () => el("profile-modal").classList.add("hidden");

el("profile-form").onsubmit = async (e) => {
  e.preventDefault();
  const { data, error } = await sb.rpc("set_user_profile", {
    p_name: el("p-name").value.trim(),
    p_role: el("p-role").value,
    p_passcode: el("p-passcode").value
  });
  if (error) return toast(error.message, "error");
  profile = data;
  el("profile-modal").classList.add("hidden");
  toast("Profile saved!");
  await loadAllData();
  safeRender();
};

async function loadAllData() {
  const [qRes, aRes, mRes] = await Promise.all([
    sb.from("questions").select("*").order("created_at", { ascending: false }),
    sb.from("answers").select("*").order("created_at", { ascending: true }),
    sb.from("materials").select("*").order("created_at", { ascending: false })
  ]);
  state.questions = qRes.data || [];
  state.answers = aRes.data || [];
  state.materials = mRes.data || [];
  if (profile?.role === "admin") {
    const oRes = await sb.from("notification_outbox").select("*").order("created_at", { ascending: false }).limit(50);
    state.outbox = oRes.data || [];
  }
}

function setupRealtime() {
  sb.channel("mewar-live")
    .on("postgres_changes", { event: "*", schema: "public", table: "questions" }, async () => { await loadAllData(); safeRender(); })
    .on("postgres_changes", { event: "*", schema: "public", table: "answers" }, async () => { await loadAllData(); safeRender(); })
    .on("postgres_changes", { event: "*", schema: "public", table: "materials" }, async () => { await loadAllData(); safeRender(); })
    .subscribe();
}

// Storage Upload Helper
async function uploadToStorage(bucket, file, ext) {
  const path = `${currentUser.id}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const { error } = await sb.storage.from(bucket).upload(path, file, { upsert: false });
  if (error) throw error;
  const { data } = sb.storage.from(bucket).getPublicUrl(path);
  return { url: data.publicUrl, path };
}

window.appNav = (p) => { page = p; safeRender(); };
window.setPreviewRole = (r) => { previewRole = r; page = r === "admin" ? "admin" : "home"; safeRender(); };

window.pickQuestionImage = (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (file.size > 10 * 1024 * 1024) return toast("Image max 10MB", "error");
  pendingImageFile = file;
  toast("Photo attached!");
  safeRender();
};

window.toggleVoice = async () => {
  if (mediaRecorder && mediaRecorder.state === "recording") {
    mediaRecorder.stop();
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(stream);
    audioChunks = [];
    mediaRecorder.ondataavailable = (ev) => audioChunks.push(ev.data);
    mediaRecorder.onstop = () => {
      pendingAudioBlob = new Blob(audioChunks, { type: "audio/webm" });
      stream.getTracks().forEach((t) => t.stop());
      toast("Voice note recorded!");
      safeRender();
    };
    mediaRecorder.start();
    toast("Recording voice... click button again to stop.", "info");
  } catch {
    toast("Microphone permission denied", "error");
  }
};

window.submitQuestion = async (e) => {
  e.preventDefault();
  const f = e.target;
  const title = f.title.value.trim();
  const body = f.body.value.trim();
  const subject = f.subject.value.trim() || "General";
  if (!title || !body) return;

  try {
    toast("Posting...", "info");
    let imageUrl = null, audioUrl = null;
    if (pendingImageFile) {
      const ext = pendingImageFile.name.split(".").pop() || "jpg";
      imageUrl = (await uploadToStorage("media", pendingImageFile, ext)).url;
    }
    if (pendingAudioBlob) {
      audioUrl = (await uploadToStorage("media", pendingAudioBlob, "webm")).url;
    }
    const { error } = await sb.from("questions").insert({
      title, body, subject, image_url: imageUrl, audio_url: audioUrl,
      author_id: currentUser.id, author_name: profile.name,
      author_role: effectiveRole(), author_photo: profile.photo_url
    });
    if (error) throw error;
    pendingImageFile = null;
    pendingAudioBlob = null;
    f.reset();
    isTyping = false;
    toast("Question posted!");
    await loadAllData();
    safeRender();
  } catch (err) {
    toast(err.message, "error");
  }
};

window.submitAnswer = async (e, qId) => {
  e.preventDefault();
  const text = e.target.answer.value.trim();
  if (!text) return;
  const { error } = await sb.from("answers").insert({
    question_id: qId, body: text, author_id: currentUser.id,
    author_name: profile.name, author_role: effectiveRole(), author_photo: profile.photo_url
  });
  if (error) return toast(error.message, "error");
  e.target.reset();
  isTyping = false;
  toast("Reply posted!");
  await loadAllData();
  safeRender();
};

window.toggleUpvote = async (qId) => {
  await sb.rpc("toggle_question_upvote", { p_question_id: qId });
  await loadAllData();
  safeRender();
};

window.deleteQuestion = async (qId) => {
  if (!confirm("Delete this question?")) return;
  await sb.from("questions").delete().eq("id", qId);
  await loadAllData();
  safeRender();
};

window.deleteAnswer = async (aId) => {
  if (!confirm("Delete this reply?")) return;
  await sb.from("answers").delete().eq("id", aId);
  await loadAllData();
  safeRender();
};

window.uploadMaterial = async (e) => {
  e.preventDefault();
  const f = e.target;
  const file = f.file.files[0];
  if (!file) return;
  if (file.size > 25 * 1024 * 1024) return toast("Max file size 25MB", "error");
  try {
    toast("Uploading material to Storage...", "info");
    const ext = file.name.split(".").pop() || "pdf";
    const uploaded = await uploadToStorage("materials", file, ext);
    const { error } = await sb.from("materials").insert({
      title: f.title.value.trim(),
      subject: f.subject.value.trim(),
      file_url: uploaded.url,
      file_path: uploaded.path,
      file_name: file.name,
      file_size: file.size,
      author_id: currentUser.id,
      author_name: profile.name,
      author_role: effectiveRole()
    });
    if (error) throw error;
    f.reset();
    isTyping = false;
    toast("Material uploaded!");
    await loadAllData();
    safeRender();
  } catch (err) {
    toast(err.message, "error");
  }
};

window.deleteMaterial = async (id, path) => {
  if (!confirm("Delete this material?")) return;
  if (path) await sb.storage.from("materials").remove([path]);
  await sb.from("materials").delete().eq("id", id);
  await loadAllData();
  safeRender();
};

window.openViewer = (url, title) => {
  el("viewer-title").textContent = title;
  el("viewer-download").href = url;
  el("viewer-frame").src = url;
  el("viewer-modal").classList.remove("hidden");
};
el("viewer-close").onclick = () => { el("viewer-frame").src = ""; el("viewer-modal").classList.add("hidden"); };

window.openEditProfile = () => {
  el("p-name").value = profile?.name || "";
  el("p-role").value = profile?.role || "student";
  el("p-role").dispatchEvent(new Event("change"));
  el("profile-modal").classList.remove("hidden");
};

window.setSearch = (val) => { searchQuery = val.toLowerCase(); safeRender(); };

function avatarHtml(name, photo) {
  return photo
    ? `<img src="${esc(photo)}" class="avatar" onerror="this.style.display='none'"/>`
    : `<div class="avatar-fallback">${esc((name || "U")[0].toUpperCase())}</div>`;
}

function render() {
  if (!currentUser || !profile) return;
  ["home", "notes", "profile", "admin"].forEach((p) => {
    const btn = el(`btn-nav-${p}`);
    if (btn) btn.classList.toggle("active", page === p);
  });

  const isAdmin = profile.role === "admin";
  el("btn-nav-admin").classList.toggle("hidden", !isAdmin);
  el("admin-role-switch").classList.toggle("hidden", !isAdmin);
  ["admin", "faculty", "student"].forEach((r) => el(`chip-${r}`).classList.toggle("active", previewRole === r));

  if (page === "home") {
    const filtered = state.questions.filter((q) =>
      !searchQuery || q.title.toLowerCase().includes(searchQuery) || q.body.toLowerCase().includes(searchQuery) || q.subject.toLowerCase().includes(searchQuery)
    );
    el("main-content").innerHTML = `
      <div class="card">
        <h2 style="font-size:1.15rem; margin-bottom:0.75rem;">Ask Anyone Question</h2>
        <form onsubmit="window.submitQuestion(event)" style="display:grid; gap:0.65rem;">
          <div class="grid-2">
            <input name="title" class="input" required placeholder="Question title..." maxlength="150" />
            <input name="subject" class="input" placeholder="Subject / Tag (e.g. DBMS, Exam)" maxlength="50" />
          </div>
          <textarea name="body" class="textarea" rows="3" required placeholder="Write details..."></textarea>
          <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:0.5rem;">
            <div style="display:flex; gap:0.5rem;">
              <input type="file" id="q-img-file" accept="image/*" class="hidden" onchange="window.pickQuestionImage(event)" />
              <button type="button" class="btn btn-secondary btn-sm" onclick="document.getElementById('q-img-file').click()"><i class="fas fa-image"></i> ${pendingImageFile ? "Photo Ready ✓" : "Photo"}</button>
              <button type="button" class="btn btn-secondary btn-sm" onclick="window.toggleVoice()"><i class="fas fa-microphone"></i> ${pendingAudioBlob ? "Voice Ready ✓" : "Voice"}</button>
            </div>
            <button type="submit" class="btn btn-primary"><i class="fas fa-paper-plane"></i> Post Question</button>
          </div>
        </form>
      </div>

      <div style="margin-bottom:1rem;">
        <input class="input" value="${esc(searchQuery)}" oninput="window.setSearch(this.value)" placeholder="Search questions or subjects..." />
      </div>

      ${filtered.map((q) => {
        const answers = state.answers.filter((a) => a.question_id === q.id);
        const canDel = q.author_id === currentUser.id || isAdmin;
        return `
          <article class="card">
            <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:0.75rem;">
              <div style="display:flex; gap:0.65rem; align-items:center;">
                ${avatarHtml(q.author_name, q.author_photo)}
                <div>
                  <div style="font-weight:700; font-size:0.92rem;">${esc(q.author_name)} <span class="badge">${esc(q.author_role)}</span></div>
                  <div style="font-size:0.75rem; color:var(--muted);">${esc(q.subject)} • ${fmtDate(q.created_at)}</div>
                </div>
              </div>
              ${canDel ? `<button class="btn btn-danger btn-sm" onclick="window.deleteQuestion('${q.id}')"><i class="fas fa-trash"></i></button>` : ""}
            </div>
            <h3 style="margin:0.8rem 0 0.35rem; font-size:1.1rem;">${esc(q.title)}</h3>
            <p style="white-space:pre-wrap; font-size:0.92rem; line-height:1.55;">${esc(q.body)}</p>
            ${q.image_url ? `<img src="${esc(q.image_url)}" style="max-width:100%; border-radius:0.75rem; margin-top:0.75rem; max-height:320px;" />` : ""}
            ${q.audio_url ? `<audio controls src="${esc(q.audio_url)}" style="width:100%; margin-top:0.75rem;"></audio>` : ""}
            <div style="display:flex; gap:0.75rem; align-items:center; margin:0.9rem 0; border-top:1px solid var(--border); padding-top:0.75rem;">
              <button class="btn btn-outline btn-sm" onclick="window.toggleUpvote('${q.id}')"><i class="fas fa-thumbs-up"></i> Helpful (${q.upvotes_count || 0})</button>
              <span style="font-size:0.82rem; color:var(--muted); font-weight:600;"><i class="fas fa-comment"></i> ${answers.length} Replies</span>
            </div>
            <div style="display:grid; gap:0.5rem; margin-bottom:0.75rem;">
              ${answers.map((a) => `
                <div style="background:#f9fafb; border:1px solid var(--border); border-radius:0.85rem; padding:0.75rem;">
                  <div style="display:flex; justify-content:space-between; font-size:0.78rem; margin-bottom:0.25rem;">
                    <strong>${esc(a.author_name)} (${esc(a.author_role)})</strong>
                    ${a.author_id === currentUser.id || isAdmin ? `<button style="border:none;background:none;color:var(--danger);cursor:pointer;" onclick="window.deleteAnswer('${a.id}')">Delete</button>` : ""}
                  </div>
                  <p style="font-size:0.88rem; white-space:pre-wrap;">${esc(a.body)}</p>
                </div>
              `).join("")}
            </div>
            <form onsubmit="window.submitAnswer(event, '${q.id}')" style="display:flex; gap:0.5rem;">
              <input name="answer" class="input" required placeholder="Write a helpful reply..." />
              <button class="btn btn-primary btn-sm" type="submit">Send</button>
            </form>
          </article>
        `;
      }).join("") || `<div class="card" style="text-align:center;color:var(--muted);">No questions found.</div>`}
    `;
  } else if (page === "notes") {
    const canUpload = ["faculty", "admin"].includes(effectiveRole());
    el("main-content").innerHTML = `
      ${canUpload ? `
        <div class="card">
          <h2 style="font-size:1.1rem; margin-bottom:0.75rem;">Upload Study Material (Max 25MB)</h2>
          <form onsubmit="window.uploadMaterial(event)" class="grid-2">
            <input name="title" class="input" required placeholder="Material Title" />
            <input name="subject" class="input" required placeholder="Subject" />
            <input name="file" type="file" accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx" class="input" required style="grid-column:1/-1;" />
            <button class="btn btn-primary" type="submit" style="grid-column:1/-1;">Upload Material</button>
          </form>
        </div>
      ` : ""}
      <div class="grid-3">
        ${state.materials.map((m) => `
          <div class="card">
            <span class="badge">${esc(m.subject)}</span>
            <h3 style="margin:0.5rem 0; font-size:1rem;">${esc(m.title)}</h3>
            <p style="font-size:0.75rem; color:var(--muted); margin-bottom:0.75rem;">By ${esc(m.author_name)} • ${fmtDate(m.created_at)}</p>
            <div style="display:flex; gap:0.4rem;">
              <button class="btn btn-primary btn-sm" style="flex:1;" onclick="window.openViewer('${esc(m.file_url)}', '${esc(m.title)}')">View</button>
              ${m.author_id === currentUser.id || isAdmin ? `<button class="btn btn-danger btn-sm" onclick="window.deleteMaterial('${m.id}', '${esc(m.file_path || "")}')"><i class="fas fa-trash"></i></button>` : ""}
            </div>
          </div>
        `).join("")}
      </div>
    `;
  } else if (page === "profile") {
    const myQ = state.questions.filter((q) => q.author_id === currentUser.id).length;
    const myA = state.answers.filter((a) => a.author_id === currentUser.id).length;
    el("main-content").innerHTML = `
      <div class="card" style="text-align:center;">
        <div style="display:flex; justify-content:center; margin-bottom:0.75rem;">${avatarHtml(profile.name, profile.photo_url)}</div>
        <h2>${esc(profile.name)}</h2>
        <p style="color:var(--muted); font-size:0.88rem;">${esc(profile.email)}</p>
        <div style="margin:0.65rem 0;"><span class="badge">${esc(profile.role)}</span></div>
        <button class="btn btn-primary btn-sm" onclick="window.openEditProfile()">Edit Name / Role</button>
        <div class="grid-2" style="margin-top:1.25rem;">
          <div class="card" style="margin:0;"><strong>${myQ}</strong><div style="font-size:0.8rem;color:var(--muted);">Questions Asked</div></div>
          <div class="card" style="margin:0;"><strong>${myA}</strong><div style="font-size:0.8rem;color:var(--muted);">Answers Given</div></div>
        </div>
      </div>
    `;
  } else if (page === "admin" && isAdmin) {
    el("main-content").innerHTML = `
      <div class="card">
        <h2 style="margin-bottom:0.75rem;">Notification Delivery Queue (Zero-Miss Monitor)</h2>
        <div style="display:grid; gap:0.5rem;">
          ${state.outbox.map((n) => `
            <div style="padding:0.65rem; border:1px solid var(--border); border-radius:0.75rem; display:flex; justify-content:space-between; align-items:center;">
              <div>
                <div style="font-weight:700; font-size:0.85rem;">${esc(n.title)}</div>
                <div style="font-size:0.78rem; color:var(--muted);">${esc(n.body)} • Attempts: ${n.attempts}</div>
              </div>
              <span class="badge">${esc(n.status)}</span>
            </div>
          `).join("") || `<p style="color:var(--muted);">No notifications queued yet.</p>`}
        </div>
      </div>
    `;
  }
}

// Init Session
sb.auth.onAuthStateChange(async (_event, session) => {
  if (!session?.user) {
    el("auth-screen").classList.remove("hidden");
    el("app").classList.add("hidden");
    return;
  }
  currentUser = session.user;
  el("auth-screen").classList.add("hidden");
  el("app").classList.remove("hidden");

  const { data } = await sb.from("profiles").select("*").eq("id", currentUser.id).maybeSingle();
  if (!data) {
    el("p-name").value = currentUser.user_metadata?.full_name || currentUser.email?.split("@")[0] || "Student";
    el("profile-modal").classList.remove("hidden");
    return;
  }
  profile = data;
  await loadAllData();
  setupRealtime();
  enablePush();
  safeRender();
});