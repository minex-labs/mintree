import { useEffect } from "react";
import { signalState } from "../../../lib/session-signal.js";
export const description = "Hook handler for Claude's SessionEnd event (writes state=exited)";
export default function End() {
    useEffect(() => {
        signalState("exited");
    }, []);
    return null;
}
