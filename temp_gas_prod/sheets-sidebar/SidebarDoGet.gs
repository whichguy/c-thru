/** doGet handler for ?view= routing. Delegates to ViewRouter. */
function _main(module, exports, log) {
  const ViewRouter = require('common-js/ViewRouter');

  function doGetHandler(e) {
    const result = ViewRouter.route(e);
    if (result) {
      log('[SidebarDoGet] Routed view: ' + (e.parameter?.view || 'unknown'));
      return result;
    }
    return null;
  }

  module.exports = { doGetHandler };
  module.exports.__events__ = { doGet: 'doGetHandler' };
}
__defineModule__(_main, null, { loadNow: true });