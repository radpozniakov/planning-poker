import { DECK, type CardValue } from "@pp/shared";
import { PokerCard } from "./PokerCard";
import styles from "./Deck.module.css";

interface Props {
  selected: CardValue | null;
  disabled: boolean;
  onPick: (v: CardValue) => void;
}

export function Deck({ selected, disabled, onPick }: Props) {
  return (
    <div className={styles.deck} role="group" aria-label="Voting deck">
      {DECK.map((value) => (
        <PokerCard
          key={value}
          value={value}
          selected={selected === value}
          disabled={disabled}
          onPick={() => onPick(value)}
        />
      ))}
    </div>
  );
}
