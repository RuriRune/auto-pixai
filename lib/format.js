// Human-readable durations for logs, alerts, and history messages —
// "2 minutes" rather than "120000ms".
function formatDuration(ms) {
	const totalSeconds = Math.round(ms / 1000);
	if (totalSeconds < 60) {
		return `${totalSeconds} second${totalSeconds === 1 ? "" : "s"}`;
	}
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	const minPart = `${minutes} minute${minutes === 1 ? "" : "s"}`;
	if (seconds === 0) return minPart;
	return `${minPart} ${seconds} second${seconds === 1 ? "" : "s"}`;
}

module.exports = { formatDuration };
