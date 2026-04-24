// Temporary auth helper — safe to delete after running once.
function slideAuthTest() {
  const pres = SlidesApp.create('_auth_test_tmp');
  DriveApp.getFileById(pres.getId()).setTrashed(true);
  return 'presentations scope authorized';
}
