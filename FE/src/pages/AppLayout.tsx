import { Link, Outlet } from "react-router-dom";
import styles from "./AppLayout.module.css";

export default function AppLayout() {
  return (
    <div className={styles.appShell}>
      <header className={styles.appHeader}>
        <Link className={styles.brand} to="/">
          <span className={styles.brandMark}>♠</span>
          <span className={styles.brandName}>Planning Picker</span>
        </Link>
      </header>

      <main className={styles.appMain}>
        <Outlet />
      </main>
    </div>
  );
}
