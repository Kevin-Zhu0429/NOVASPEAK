import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import WarpBackground from "./components/wrap-shader.jsx";
import "./index.css";

createRoot(document.getElementById("root")).render(
  <>
    <WarpBackground />
    <App />
  </>
);