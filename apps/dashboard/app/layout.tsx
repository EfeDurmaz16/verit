import type { Metadata } from "next";
import Link from "next/link";
import { Geist, Geist_Mono } from "next/font/google";
import { currentSession } from "@/lib/session";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Cyclops",
  description: "Behavior proof for pull requests: run history and proof pages",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const session = await currentSession();
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
      <body>
        <header className="border-b border-line bg-surface">
          <div className="mx-auto flex max-w-[1080px] flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 sm:px-6">
            <Link href="/" className="text-[13px] font-medium">
              cyclops
            </Link>
            <span className="text-[12px] text-ink-3">behavior proof</span>
            {session ? (
              <span className="ml-auto flex items-center gap-3 text-[12px] text-ink-3">
                <span className="font-mono">{session.login}</span>
                {session.dev ? (
                  <span className="rounded-[4px] bg-warn-soft px-1.5 py-px text-[10px] font-medium uppercase tracking-wide text-warn">
                    dev
                  </span>
                ) : (
                  <form action="/api/auth/logout" method="post">
                    <button type="submit" className="text-ink-3 hover:text-ink">
                      sign out
                    </button>
                  </form>
                )}
              </span>
            ) : (
              <a
                href="/api/auth/github"
                className="ml-auto rounded-md border border-line-strong px-2.5 py-1 text-[12px] font-medium hover:border-accent hover:text-accent-text"
              >
                Sign in with GitHub
              </a>
            )}
          </div>
        </header>
        <main className="mx-auto max-w-[1080px] px-4 py-6 sm:px-6">{children}</main>
      </body>
    </html>
  );
}
