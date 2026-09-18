import Link from 'next/link'

interface Props {
  searchParams: Promise<{ token_hash?: string; type?: string }>
}

export default async function ConfirmEmailPage({ searchParams }: Props) {
  const { token_hash, type } = await searchParams

  if (!token_hash || !type || (type !== 'email' && type !== 'signup')) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-white">
        <div className="max-w-sm px-6 text-center">
          <p className="text-sm text-neutral-900 mb-4">
            This verification link is invalid.
          </p>
          <Link href="/" className="text-sm text-neutral-900 underline">
            Back to sign in
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-white">
      <div className="max-w-sm px-6 text-center">
        <h1 className="text-lg font-semibold text-neutral-900 mb-2">Verify your email</h1>
        <p className="text-sm text-neutral-600 mb-6">
          Click below to finish verifying. This step stops automatic email scanners from using your link.
        </p>
        <form method="POST" action="/auth/callback">
          <input type="hidden" name="token_hash" value={token_hash} />
          <input type="hidden" name="type" value={type} />
          <button
            type="submit"
            className="w-full bg-neutral-900 text-white rounded px-3 py-2 text-sm font-medium"
          >
            Verify email
          </button>
        </form>
        <p className="mt-4 text-sm text-neutral-500">
          Already verified?{' '}
          <Link href="/" className="text-neutral-900 underline">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  )
}
