import type { CardValue, PublicParticipant, Vote } from "@pp/shared";
import { cn } from "@/lib/utils";
import styles from "./ParticipantList.module.css";

interface Props {
  participants: PublicParticipant[];
  myId: string | null;
  revealed: boolean;
  votes: Vote[];
}

function revealedValue(votes: Vote[], participantId: string): CardValue | null {
  const v = votes.find((vote) => vote.participantId === participantId);
  return v ? v.cardValue : null;
}

export function ParticipantList({
  participants,
  myId,
  revealed,
  votes,
}: Props) {
  return (
    <ul className={styles.participants}>
      {participants.map((p) => (
        <li
          key={p.id}
          className={cn(styles.participant, p.id === myId && styles.me)}
        >
          <span className={styles.name}>
            {p.displayName}
            {p.id === myId && <span className={styles.you}>(you)</span>}
            {p.isHost && (
              <span className={cn(styles.badge, styles.host)}>Host</span>
            )}
          </span>

          {revealed ? (
            <span
              className={cn(
                styles.value,
                revealedValue(votes, p.id) === null && styles.empty,
              )}
            >
              {revealedValue(votes, p.id) ?? "—"}
            </span>
          ) : (
            <span
              className={cn(styles.dot, p.hasVoted && styles.voted)}
              aria-label={p.hasVoted ? "Voted" : "Not voted yet"}
              title={p.hasVoted ? "Voted" : "Not voted yet"}
            />
          )}
        </li>
      ))}
    </ul>
  );
}
