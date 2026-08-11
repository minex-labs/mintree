import { z } from "zod";
export declare const description = "Launch a Claude orchestrator in the repo root to resolve a batch of tickets";
export declare const args: z.ZodDefault<z.ZodArray<z.ZodString>>;
export declare const options: z.ZodObject<{
    prompt: z.ZodOptional<z.ZodString>;
    promptFile: z.ZodOptional<z.ZodString>;
    permissionMode: z.ZodOptional<z.ZodEnum<{
        default: "default";
        auto: "auto";
    }>>;
    rcName: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
type Props = {
    args: z.infer<typeof args>;
    options: z.infer<typeof options>;
};
export default function Orchestrate({ args: ids, options }: Props): import("react/jsx-runtime").JSX.Element;
export {};
