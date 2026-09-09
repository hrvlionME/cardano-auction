// Must come first: it installs the Node globals Lucid's dependencies expect,
// and ES modules evaluate in import order.
import "./polyfills.ts";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./styles.css";


createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
