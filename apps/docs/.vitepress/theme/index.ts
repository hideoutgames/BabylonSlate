import type { Theme } from "vitepress";
import DefaultTheme from "vitepress/theme";
import "@fontsource-variable/onest";
import {
  Aperture,
  AudioLines,
  Box,
  BrainCircuit,
  Bug,
  FolderOpen,
  Gamepad2,
  Globe,
  Grid2x2,
  Orbit,
  PanelsTopLeft,
  Workflow,
} from "lucide-vue-next";
import "./custom.css";
import "../cache/node-previews/node-previews.css";
import "./node-previews.css";

/** Lucide icons available to Markdown pages as `<IconName />`. */
const icons = {
  Aperture,
  AudioLines,
  Box,
  BrainCircuit,
  Bug,
  FolderOpen,
  Gamepad2,
  Globe,
  Grid2x2,
  Orbit,
  PanelsTopLeft,
  Workflow,
};

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    for (const [name, icon] of Object.entries(icons)) {
      app.component(`Icon${name}`, icon);
    }
  },
} satisfies Theme;
