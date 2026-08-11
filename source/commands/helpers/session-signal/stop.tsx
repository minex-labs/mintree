import { useEffect } from "react";
import { signalState } from "../../../lib/session-signal.js";

export const description = "Hook handler for Claude's Stop event (writes state=idle)";

export default function Stop() {
	useEffect(() => {
		signalState("idle");
	}, []);
	return null;
}
