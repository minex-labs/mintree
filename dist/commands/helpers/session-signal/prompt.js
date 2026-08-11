import { useEffect } from "react";
import { signalState } from "../../../lib/session-signal.js";
export const description = "Hook handler for Claude's UserPromptSubmit event (writes state=active)";
export default function Prompt() {
    useEffect(() => {
        signalState("active");
    }, []);
    return null;
}
