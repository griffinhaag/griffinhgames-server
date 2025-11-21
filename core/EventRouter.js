// Currently minimal; you can expand this to route events
// to specific controllers or sub-systems if needed.
export function createEventRouter() {
    const handlers = new Map(); // Map<eventName, handlerFn>
  
    function register(eventName, handlerFn) {
      handlers.set(eventName, handlerFn);
    }
  
    function dispatch(eventName, payload) {
      const handler = handlers.get(eventName);
      if (handler) {
        handler(payload);
      }
    }
  
    return {
      register,
      dispatch
    };
  }
  