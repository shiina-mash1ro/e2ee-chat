import { createApp } from "vue";
import {
  NAlert,
  NButton,
  NCard,
  NConfigProvider,
  NDivider,
  NDrawer,
  NDrawerContent,
  NForm,
  NInput,
  NLayout,
  NLayoutContent,
  NList,
  NListItem,
  NMessageProvider,
  NModal,
  NPopover,
  NScrollbar,
  NSpace,
  NSwitch,
  NThing,
} from "naive-ui";
import App from "./App.vue";
import "./style.css";

const app = createApp(App);

Object.entries({
  NAlert,
  NButton,
  NCard,
  NConfigProvider,
  NDivider,
  NDrawer,
  NDrawerContent,
  NForm,
  NInput,
  NLayout,
  NLayoutContent,
  NList,
  NListItem,
  NMessageProvider,
  NModal,
  NPopover,
  NScrollbar,
  NSpace,
  NSwitch,
  NThing,
}).forEach(([name, component]) => app.component(name, component));

app.mount("#app");
