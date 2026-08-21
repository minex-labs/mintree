import { z } from "zod";
export declare const description = "Create a worktree for an issue branch";
export declare const args: z.ZodTuple<[z.ZodString], null>;
export declare const options: z.ZodObject<{
    base: z.ZodOptional<z.ZodString>;
    work: z.ZodDefault<z.ZodBoolean>;
    prompt: z.ZodOptional<z.ZodString>;
    exact: z.ZodDefault<z.ZodBoolean>;
    permissionMode: z.ZodOptional<z.ZodEnum<{
        default: "default";
        auto: "auto";
    }>>;
}, z.core.$strip>;
type Props = {
    args: z.infer<typeof args>;
    options: z.infer<typeof options>;
};
export default function Create({ args, options }: Props): import("react/jsx-runtime").JSX.Element;
export {};
