self.addEventListener("push", (event) => {
  const data = event.data ? event.data.json() : { title: "MewarHelpNots", body: "New campus update!" };
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: "./icon.png",
      badge: "./icon.png",
      data: { url: data.url || "./" }
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(clients.openWindow(event.notification.data?.url || "./"));
});