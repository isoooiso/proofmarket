import { Buffer } from "buffer";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

(globalThis as unknown as { Buffer: typeof Buffer }).Buffer = Buffer;
if (typeof window !== "undefined") {
  (window as unknown as { Buffer: typeof Buffer }).Buffer = Buffer;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
