import { z } from "zod";
export declare const description = "Launch Claude in the current worktree (creates or resumes a session)";
export declare const options: z.ZodObject<{
    prompt: z.ZodOptional<z.ZodString>;
    promptFile: z.ZodOptional<z.ZodString>;
    permissionMode: z.ZodOptional<z.ZodEnum<{
        default: "default";
        auto: "auto";
    }>>;
}, z.core.$strip>;
type Props = {
    options: z.infer<typeof options>;
};
export default function Work({ options }: Props): import("react/jsx-runtime").JSX.Element;
export {};
