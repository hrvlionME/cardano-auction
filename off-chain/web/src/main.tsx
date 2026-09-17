// Polyfills first: ES modules evaluate depth-first in import order, and Lucid's
// dependency tree reaches for `Buffer`, `process` and `global` at module scope.
// Anything imported above this line would pull Lucid in before they exist.
import "./polyfills.ts";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App.tsx";
import { SessionProvider } from "./session.tsx";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("No #root element in index.html");

createRoot(root).render(
  <StrictMode>
    {/*
      Opt in to the v7 behaviours now rather than carrying two deprecation
      warnings in the console. `startTransition` wraps router state updates,
      and `relativeSplatPath` fixes relative resolution inside the splat route
      that /account/* uses -- which this app relies on for its nested tabs.
    */}
    <BrowserRouter
      future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
    >
      <SessionProvider>
        <App />
      </SessionProvider>
    </BrowserRouter>
  </StrictMode>,
);
