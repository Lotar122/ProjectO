import { NextResponse } from 'next/server';

export async function GET() {
  // Redirect to the main page
  return NextResponse.redirect('/', 307); // 307 = temporary redirect
}