// Completion Notifier — dogfood extension for the Phase 2 host API.
// Tracks live sessions via title-changed, remembers first-seen times in
// storage (survives restarts), and notifies when a long-lived session exits.

var THRESHOLD_MS = 30 * 1000;

var seen = oppa.storage.get("seen") || {};

function persist() {
  oppa.storage.set("seen", seen);
}

oppa.on("title-changed", function (evt) {
  if (!(evt.id in seen)) {
    seen[evt.id] = Date.now();
    persist();
  }
});

oppa.on("session-exit", function (evt) {
  var startedAt = seen[evt.id];
  delete seen[evt.id];
  persist();

  // Unknown age (never saw it alive): assume it was long-running so a
  // session that started before this extension did still notifies once.
  var ranMs = typeof startedAt === "number" ? Date.now() - startedAt : THRESHOLD_MS;
  if (ranMs >= THRESHOLD_MS) {
    var seconds = Math.round(ranMs / 1000);
    oppa.notify(
      "Terminal finished",
      "A session ended after " + seconds + "s" + (evt.code != null ? " (exit " + evt.code + ")" : "")
    );
  }
});
