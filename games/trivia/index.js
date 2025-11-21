import { logInfo } from "../../utils/logger.js";

const triviaGame = {
  id: "trivia",
  name: "Trivia Battle",

  create({ io, room, roomManager }) {
    const state = {
      roomCode: room.code,
      startedAt: Date.now()
      // Add trivia-specific state later (questions, scores, etc.)
    };

    logInfo(`Trivia game created for room ${room.code}`);

    function handleEvent({ eventName, payload, socketId }) {
      logInfo(
        `Trivia event in room ${state.roomCode}: ${eventName} from ${socketId}`
      );

      // Example: io.to(state.roomCode).emit("game:trivia:update", {...})
    }

    function getState() {
      return { ...state };
    }

    function teardown() {
      logInfo(`Trivia game teardown for room ${state.roomCode}`);
    }

    return {
      handleEvent,
      getState,
      teardown
    };
  }
};

export default triviaGame;
