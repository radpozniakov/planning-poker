import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { LIMITS } from "@pp/shared";
import { createRoom } from "@/lib/socket";
import { saveSession } from "@/lib/session";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import styles from "./Landing.module.css";

export default function Landing() {
  const navigate = useNavigate();
  const [createName, setCreateName] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [joinName, setJoinName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onCreate(
    event: React.FormEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    const name = createName.trim();
    if (!name || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await createRoom(name);
      if (result.ok) {
        saveSession({
          participantId: result.participantId,
          displayName: name,
          roomCode: result.roomCode,
        });
        navigate(`/${result.roomCode}`);
      } else {
        setError(result.error.message);
      }
    } catch {
      setError("Could not reach the server. Is it running?");
    } finally {
      setBusy(false);
    }
  }

  function onJoin(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const code = joinCode.trim().toUpperCase();
    const name = joinName.trim();
    if (code.length !== LIMITS.roomCodeLength || !name) return;
    // Persist the name so the room page can auto-join without re-prompting.
    saveSession({ participantId: "", displayName: name, roomCode: code });
    navigate(`/${code}`);
  }

  function onCodeInput(event: React.ChangeEvent<HTMLInputElement>): void {
    setJoinCode(event.currentTarget.value.toUpperCase());
  }

  return (
    <div className={styles.landing}>
      <header className={styles.hero}>
        <h1>Plan together, pick faster.</h1>
        <p className={styles.subtitle}>
          Real-time planning poker. Create a room, share the link, estimate as a
          team.
        </p>
      </header>

      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}

      <div className={styles.actions}>
        <form className={styles.panel} onSubmit={onCreate}>
          <h2>Create a room</h2>
          <label className={styles.field}>
            <span>Your name</span>
            <Input
              type="text"
              placeholder="e.g. Alex"
              value={createName}
              onChange={(e) => setCreateName(e.target.value)}
              maxLength={LIMITS.displayNameMax}
              autoComplete="off"
            />
          </label>
          <Button type="submit" disabled={!createName.trim() || busy}>
            {busy ? "Creating…" : "Create room"}
          </Button>
        </form>

        <form className={styles.panel} onSubmit={onJoin}>
          <h2>Join a room</h2>
          <label className={styles.field}>
            <span>Room code</span>
            <Input
              type="text"
              placeholder="ABC123"
              value={joinCode}
              onChange={onCodeInput}
              maxLength={LIMITS.roomCodeLength}
              autoComplete="off"
              autoCapitalize="characters"
              className={styles.code}
            />
          </label>
          <label className={styles.field}>
            <span>Your name</span>
            <Input
              type="text"
              placeholder="e.g. Sam"
              value={joinName}
              onChange={(e) => setJoinName(e.target.value)}
              maxLength={LIMITS.displayNameMax}
              autoComplete="off"
            />
          </label>
          <Button
            type="submit"
            variant="secondary"
            disabled={
              joinCode.trim().length !== LIMITS.roomCodeLength ||
              !joinName.trim()
            }
          >
            Join room
          </Button>
        </form>
      </div>
    </div>
  );
}
