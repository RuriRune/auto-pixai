// Single source of truth for "is a run active, what step is it on, and how
// do we cancel it." Both claimer.js (which updates it as a run progresses)
// and server.js (which exposes it via the API and triggers cancellation)
// share this module.

let state = {
	running: false,
	step: null,
	startedAt: null,
	controller: null,
};

function startRun() {
	state.running = true;
	state.startedAt = Date.now();
	state.step = "Starting";
	state.controller = new AbortController();
	return state.controller;
}

function setStep(step) {
	if (state.running) state.step = step;
}

function endRun() {
	state.running = false;
	state.step = null;
	state.startedAt = null;
	state.controller = null;
}

function getState() {
	return { running: state.running, step: state.step, startedAt: state.startedAt };
}

// Returns true if a run was actually cancelled, false if none was running.
function cancel() {
	if (state.running && state.controller) {
		state.controller.abort();
		return true;
	}
	return false;
}

module.exports = { startRun, setStep, endRun, getState, cancel };
