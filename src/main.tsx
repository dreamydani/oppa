import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles/theme.css";
// After theme.css: the motion layer consumes its tokens and must not be able
// to shadow the base element rules.
import "./styles/motion.css";
import { applyChannelIdentity } from "./lib/channel";

// Set the window title from the build channel: "Developer OPPA" for a dev
// build, "oppa" (unchanged) for stable. Fire-and-forget; the default stable
// title in index.html is already "OPPA" until this resolves.
void applyChannelIdentity();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
