import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import { visible } from "./safeText.js";
// Rule 24: JsonView uses the lab's visible() guard for strings in both modes.
window.__safeTextVisible = visible;
import "./standalone-ui.css";
import "./top-menu/top-menu.css";
import "./tokens.css";
import "./app.css";

createRoot(document.getElementById("root")).render(<App />);
