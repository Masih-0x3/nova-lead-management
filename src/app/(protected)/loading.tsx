import { AsyncState } from "@/components/async-state";

export default function ProtectedLoading() {
  return (
    <div className="mx-auto w-full max-w-3xl py-6">
      <AsyncState
        variant="loading"
        title="Loading workspace"
        description="Resolving your tenant scope and reading the latest canonical state."
      />
    </div>
  );
}
