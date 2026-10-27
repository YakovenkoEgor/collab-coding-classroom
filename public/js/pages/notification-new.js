// /notifications/new - the announcement form, empty. Publishing it navigates
// to the notification's own address.

(async function initNotificationNew() {
  await initTeacherPage();
  renderNotificationForm(null);
})();
