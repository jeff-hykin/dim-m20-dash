import { createRoot } from "react-dom/client"
import { App } from "./App.tsx"
import { initTheme } from "./dim-app/source/theme.js"
import "./dim-app/source/theme.css"
import "./app.css"

initTheme()
createRoot(document.getElementById("root")!).render(<App />)
