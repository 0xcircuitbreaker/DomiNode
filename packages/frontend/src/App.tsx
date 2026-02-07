import { Routes, Route } from "react-router-dom";
import Layout from "./components/Layout";
import LoginPage from "./pages/LoginPage";
import DashboardPage from "./pages/DashboardPage";
import ApiKeysPage from "./pages/ApiKeysPage";
import WalletPage from "./pages/WalletPage";
import UsagePage from "./pages/UsagePage";
import PlansPage from "./pages/PlansPage";
import AdminPage from "./pages/AdminPage";

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/" element={<Layout />}>
        <Route index element={<DashboardPage />} />
        <Route path="keys" element={<ApiKeysPage />} />
        <Route path="wallet" element={<WalletPage />} />
        <Route path="usage" element={<UsagePage />} />
        <Route path="plans" element={<PlansPage />} />
        <Route path="admin" element={<AdminPage />} />
      </Route>
    </Routes>
  );
}
