import { z } from "zod";
export declare const description = "List mintree-managed worktrees with dirty/ahead/PR status";
export declare const options: z.ZodObject<{
    pr: z.ZodDefault<z.ZodBoolean>;
}, z.core.$strip>;
type Props = {
    options: z.infer<typeof options>;
};
export default function List({ options }: Props): import("react/jsx-runtime").JSX.Element;
export {};
