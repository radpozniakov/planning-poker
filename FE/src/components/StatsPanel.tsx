import type { VoteStats } from "@pp/shared";
import styles from "./StatsPanel.module.css";

interface Props {
  stats: VoteStats;
}

function fmt(value: number | null): string {
  return value === null ? "—" : String(value);
}

function fmtAvg(value: number | null): string {
  if (value === null) return "—";
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export function StatsPanel({ stats }: Props) {
  const hasNumeric = stats.numericCount > 0;

  return (
    <div className={styles.stats}>
      {hasNumeric ? (
        <>
          <div className={styles.grid}>
            <div className={styles.stat}>
              <span className={styles.label}>Min</span>
              <span className={styles.num}>{fmt(stats.min)}</span>
            </div>
            <div className={styles.stat}>
              <span className={styles.label}>Max</span>
              <span className={styles.num}>{fmt(stats.max)}</span>
            </div>
            <div className={styles.stat}>
              <span className={styles.label}>Average</span>
              <span className={styles.num}>{fmtAvg(stats.average)}</span>
            </div>
            <div className={styles.stat}>
              <span className={styles.label}>Numeric votes</span>
              <span className={styles.num}>{stats.numericCount}</span>
            </div>
          </div>
          {stats.allAgree && <p className={styles.agree}>All agree ✅</p>}
        </>
      ) : (
        <p className={styles.empty}>No numeric votes</p>
      )}
    </div>
  );
}
