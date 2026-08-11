import { z } from "zod";
export declare const description = "Output shell integration script (eval in your shell rc)";
export declare const args: z.ZodTuple<[z.ZodDefault<z.ZodEnum<{
    zsh: "zsh";
    bash: "bash";
}>>], null>;
type Props = {
    args: z.infer<typeof args>;
};
export default function ShellInit({ args }: Props): null;
export {};
