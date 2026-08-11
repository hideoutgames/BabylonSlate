import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@babylonslate/ui/styles/globals.css";
import "@babylonslate/editor-kit/styles/context-menu.css";
import App from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
