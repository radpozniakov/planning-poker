import { useState } from "react";
import { LIMITS, type Task } from "@pp/shared";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import styles from "./TaskBar.module.css";

interface Props {
  task: Task | null;
  isHost: boolean;
  onSetTask: (description: string) => void;
}

export function TaskBar({ task, isHost, onSetTask }: Props) {
  const [draft, setDraft] = useState("");

  function handleSubmit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const description = draft.trim();
    if (!description) return;
    onSetTask(description);
    setDraft("");
  }

  return (
    <section className={styles.taskbar}>
      <div className={styles.current}>
        <span className={styles.label}>Current task</span>
        <p className={cn(styles.text, !task && styles.none)}>
          {task ? task.description : "No task yet"}
        </p>
      </div>

      {isHost && (
        <form className={styles.setForm} onSubmit={handleSubmit}>
          <Input
            type="text"
            placeholder="Describe the task to estimate…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            maxLength={LIMITS.taskDescriptionMax}
            aria-label="Task description"
            autoComplete="off"
            autoCapitalize="off"
            className={styles.input}
          />
          <Button type="submit" disabled={!draft.trim()} className={styles.btn}>
            Set task
          </Button>
        </form>
      )}
    </section>
  );
}
