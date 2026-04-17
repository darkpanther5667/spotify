import React from "react";
import ReactDOM from "react-dom/client";

// SpotiClone uses plain HTML/CSS/JS served from public/
// React is minimal - the actual app is in public/index.html
const root = document.getElementById("root");
if (root) {
  ReactDOM.createRoot(root).render(<React.StrictMode><div /></React.StrictMode>);
}
