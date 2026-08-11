import { z } from "zod";
export declare const description = "Update mintree to the latest version (npm i -g mintree)";
export declare const options: z.ZodObject<{
    force: z.ZodDefault<z.ZodBoolean>;
}, z.core.$strip>;
type Props = {
    options: z.infer<typeof options>;
};
export default function Update({ options: opts }: Props): import("react/jsx-runtime").JSX.Element;
export {};
