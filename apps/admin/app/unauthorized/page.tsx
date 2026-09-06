export const metadata = { title: "Không có quyền · Circa Tool-tip Admin" };

export default function UnauthorizedPage() {
  return (
    <div className="login-wrap">
      <div className="card login-card stack">
        <h1 className="page-title" style={{ fontSize: 18 }}>Không có quyền</h1>
        <p className="muted" style={{ margin: 0 }}>
          Tài khoản này đã đăng nhập nhưng không nằm trong danh sách admin. Liên hệ người quản trị để
          được thêm vào <span className="mono">admin_allowlist</span>.
        </p>
        <form action="/auth/signout" method="post">
          <button className="btn" type="submit">Đăng xuất</button>
        </form>
      </div>
    </div>
  );
}
