import { logInfo } from "../../utils/logger.js";

const reflexGame = {
  id: "reflex",
  name: "Reflex Challenge",

  create({ io, room, roomManager }) {
    const state = {
      roomCode: room.code,
      startedAt: Date.now()
      // Add any game-specific state you need later
    };

    logInfo(`Reflex game created for room ${room.code}`);

    function handleEvent({ eventName, payload, socketId }) {
      // This is where you handle game-specific events in the future.
      // For now, just log them so you can see the flow working.
      logInfo(
        `Reflex event in room ${state.roomCode}: ${eventName} from ${socketId}`
      );

      // Example of broadcasting something back:
      // io.to(state.roomCode).emit("game:reflex:someUpdate", { ... });
    }

    function getState() {
      return { ...state };
    }

    function teardown() {
      logInfo(`Reflex game teardown for room ${state.roomCode}`);
    }

    return {
      handleEvent,
      getState,
      teardown
    };
  }
};

export default reflexGame;
