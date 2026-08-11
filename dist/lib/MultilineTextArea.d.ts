interface MultilineTextAreaProps {
    value: string;
    onChange: (value: string) => void;
    onSubmit: () => void;
    onCancel: () => void;
    placeholder?: string;
    width?: number;
    height?: number;
    focus?: boolean;
}
export declare function MultilineTextArea({ value, onChange, onSubmit, onCancel, placeholder, width, height, focus, }: MultilineTextAreaProps): import("react/jsx-runtime").JSX.Element;
export {};
