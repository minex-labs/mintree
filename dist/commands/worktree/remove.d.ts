import { z } from "zod";
export declare const description = "Remove a worktree (the branch and metadata are preserved so you can re-attach later)";
export declare const args: z.ZodTuple<[z.ZodString], null>;
export declare const options: z.ZodObject<{
    force: z.ZodDefault<z.ZodBoolean>;
}, z.core.$strip>;
type Props = {
    args: z.infer<typeof args>;
    options: z.infer<typeof options>;
};
export default function Remove({ args, options }: Props): import("react/jsx-runtime").JSX.Element;
export {};
