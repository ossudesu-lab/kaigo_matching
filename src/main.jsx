import React from "react";
import { createRoot } from "react-dom/client";
import "./storage.js"; // window.storage シム（App より先に読む）
import App from "./App.jsx";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
