import { useEffect } from "react";
import { signalState } from "../../../lib/session-signal.js";

export const description = "Hook handler for Claude's Notification event (writes state=waiting)";

export default function Notification() {
	useEffect(() => {
		signalState("waiting");
	}, []);
	return null;
}
