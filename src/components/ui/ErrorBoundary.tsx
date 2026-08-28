"use client";

import { Component, ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error?: Error;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: any) {
    console.error('ErrorBoundary caught:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        this.props.fallback || (
          <div
            style={{
              padding: 40,
              textAlign: 'center',
              color: '#e74c3c',
              background: '#25282b',
              borderRadius: 8,
              border: '1px solid #e74c3c',
            }}
          >
            <h3 style={{ marginBottom: 8 }}>⚠️ Что-то пошло не так</h3>
            <p style={{ color: '#9ca3af', fontSize: 13 }}>
              {this.state.error?.message || 'Неизвестная ошибка'}
            </p>
            <button
              onClick={() => this.setState({ hasError: false })}
              style={{
                marginTop: 16,
                padding: '6px 14px',
                background: '#323538',
                border: '1px solid #3a3d40',
                color: '#eeeeee',
                borderRadius: 4,
                cursor: 'pointer',
              }}
            >
              Попробовать снова
            </button>
          </div>
        )
      );
    }
    return this.props.children;
  }
}
