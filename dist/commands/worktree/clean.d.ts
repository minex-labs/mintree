import { z } from "zod";
export declare const description = "Remove worktrees whose PR is merged or closed";
export declare const options: z.ZodObject<{
    yes: z.ZodDefault<z.ZodBoolean>;
    force: z.ZodDefault<z.ZodBoolean>;
}, z.core.$strip>;
type Props = {
    options: z.infer<typeof options>;
};
export default function Clean({ options }: Props): import("react/jsx-runtime").JSX.Element;
export {};
