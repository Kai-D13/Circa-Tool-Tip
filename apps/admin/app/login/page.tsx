import { LoginForm } from "./login-form";

export const metadata = { title: "Đăng nhập · Circa Tool-tip Admin" };

export default function LoginPage() {
  return (
    <div className="login-wrap">
      <div className="card login-card stack">
        <div>
          <div className="shell-brand">Circa Tool-tip</div>
          <h1 className="page-title" style={{ fontSize: 18 }}>Đăng nhập Admin</h1>
          <p className="muted" style={{ margin: 0 }}>Chỉ tài khoản trong danh sách admin mới vào được.</p>
        </div>
        <LoginForm />
      </div>
    </div>
  );
}
