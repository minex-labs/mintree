import { z } from "zod";
export declare const description = "Initialize the current repo for mintree (creates .mintree/, updates .gitignore)";
export declare const options: z.ZodObject<{
    provider: z.ZodDefault<z.ZodEnum<{
        github: "github";
        linear: "linear";
    }>>;
    workspace: z.ZodOptional<z.ZodString>;
    team: z.ZodOptional<z.ZodArray<z.ZodString>>;
    apiUrl: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
type Props = {
    options: z.infer<typeof options>;
};
export default function Init({ options: opts }: Props): import("react/jsx-runtime").JSX.Element;
export {};
