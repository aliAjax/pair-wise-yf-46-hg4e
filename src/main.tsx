import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Provider } from "react-redux";
import { ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";
import { BrowserRouter } from "react-router-dom";
import i18n from "./app/i18n";
import { I18nextProvider } from "react-i18next";
import { store } from "./store";
import App from "./App";
import "antd/dist/reset.css";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode><Provider store={store}><I18nextProvider i18n={i18n}><ConfigProvider locale={zhCN}><BrowserRouter><App /></BrowserRouter></ConfigProvider></I18nextProvider></Provider></StrictMode>
);
