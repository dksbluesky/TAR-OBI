'use strict';

self.addEventListener('notificationclick', event => {
    event.notification.close();
});
