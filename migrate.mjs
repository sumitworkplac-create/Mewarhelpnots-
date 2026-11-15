import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const dump = JSON.parse(fs.readFileSync("./firebase-export.json", "utf8"));

function dataUrlToBuffer(dataUrl) {
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl || "");
  if (!match) return null;
  return { mime: match[1], buffer: Buffer.from(match[2], "base64") };
}

const qMap = new Map();

for (const [oldId, q] of Object.entries(dump.questions || {})) {
  let image_url = null, audio_url = null;
  const img = dataUrlToBuffer(q.imageUrl);
  if (img) {
    const path = `migrated/${oldId}.webp`;
    await sb.storage.from("media").upload(path, img.buffer, { contentType: img.mime, upsert: true });
    image_url = sb.storage.from("media").getPublicUrl(path).data.publicUrl;
  }
  const aud = dataUrlToBuffer(q.audioUrl);
  if (aud) {
    const path = `migrated/${oldId}.webm`;
    await sb.storage.from("media").upload(path, aud.buffer, { contentType: aud.mime, upsert: true });
    audio_url = sb.storage.from("media").getPublicUrl(path).data.publicUrl;
  }
  const { data } = await sb.from("questions").insert({
    title: q.title, body: q.body, image_url, audio_url,
    author_name: q.authorName || "Student", author_role: q.authorRole || "student",
    author_photo: q.authorPhoto || "", created_at: q.createdAt ? new Date(q.createdAt).toISOString() : new Date().toISOString()
  }).select("id").single();
  if (data) qMap.set(oldId, data.id);
}

for (const a of Object.values(dump.answers || {})) {
  const newQId = qMap.get(a.questionId);
  if (!newQId) continue;
  await sb.from("answers").insert({
    question_id: newQId, body: a.body,
    author_name: a.authorName || "Student", author_role: a.authorRole || "student",
    author_photo: a.authorPhoto || "", created_at: a.createdAt ? new Date(a.createdAt).toISOString() : new Date().toISOString()
  });
}

for (const [oldId, n] of Object.entries(dump.notes || {})) {
  const doc = dataUrlToBuffer(n.pdfUrl);
  if (!doc) continue;
  const path = `migrated/${oldId}_${n.fileName || "file.pdf"}`;
  await sb.storage.from("materials").upload(path, doc.buffer, { contentType: doc.mime, upsert: true });
  const file_url = sb.storage.from("materials").getPublicUrl(path).data.publicUrl;
  await sb.from("materials").insert({
    title: n.title, subject: n.subject, file_url, file_path: path,
    file_name: n.fileName || "document.pdf", author_name: n.authorName || "Faculty",
    author_role: n.authorRole || "faculty",
    created_at: n.createdAt ? new Date(n.createdAt).toISOString() : new Date().toISOString()
  });
}

console.log("Migration complete!");