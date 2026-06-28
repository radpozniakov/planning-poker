import type { CardValue } from "@pp/shared";
import { cn } from "@/lib/utils";
import styles from "./PokerCard.module.css";

interface Props {
  value: CardValue;
  selected: boolean;
  disabled: boolean;
  onPick: () => void;
}

export function PokerCard({ value, selected, disabled, onPick }: Props) {
  return (
    <button
      type="button"
      className={cn(styles.card, selected && styles.selected)}
      disabled={disabled}
      aria-pressed={selected}
      aria-label={`Pick ${value}`}
      onClick={onPick}
    >
      <span className={styles.face}>{value}</span>
    </button>
  );
}
